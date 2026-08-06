import os
import pickle
import json
import random
import torch
import torch.nn as nn
import numpy as np
from torch.utils.data import Dataset, DataLoader
from config import *

from scipy.interpolate import interp1d

def resizeFeature(inputData, newSize, sample_method):
    # inputX: (temporal_length,feature_dimension) #
    originalSize = len(inputData)
    # print originalSize
    if originalSize == 1:
        inputData = np.reshape(inputData, [-1])
        return np.stack([inputData] * newSize)
    x = np.array(range(originalSize))
    f = interp1d(x, inputData, axis=0, kind=sample_method)
    x_new = [i * float(originalSize - 1) / (newSize - 1) for i in range(newSize)]
    y_new = f(x_new)
    return y_new

def paddingFeature(inputData, newSize):
    y_new = np.concatenate([inputData, np.zeros([newSize-inputData.shape[0], inputData.shape[1]])], axis=0)
    return y_new

def pickle2numpy(path):
    with open(path, 'rb') as f:
        data = pickle.load(f)
    return np.array(data)

def load_feature(path):
    
    for feature_type in USE_FEATURE:
        try:
            #feature = np.concatenate([feature, pickle2numpy(path+f'_{feature_type}.pkl')], axis=1)
            feature = np.concatenate([feature, pickle2numpy(path)], axis=1)
        except:
            #feature = pickle2numpy(path+f'_{feature_type}.pkl')
            feature = pickle2numpy(path)

    if feature.shape[0] != FEATURE_LEN:
        #feature = resizeFeature(feature, FEATURE_LEN, 'nearest')
        if feature.shape[0] > FEATURE_LEN: 
            feature = resizeFeature(feature, FEATURE_LEN, 'nearest')
        else:
            feature = paddingFeature(feature, FEATURE_LEN)
    
    if feature.shape[1] != FEATURE_DIM:
        raise "feature check"
    
    return feature

         


def get_boundaries(video_annotation, interpolation=False):
    '''
    IN: annotation
    OUT: event, shot, whole
    '''
    event_boundaries = []
    for annotations in video_annotation['change_event']:
        tmp = torch.zeros(FEATURE_LEN,)
        boundary = []
        for pt in annotations:
            boundary.append(pt)
        boundary.sort()
        boundary = [int(i/TIME_UNIT) if int(i/TIME_UNIT) < FEATURE_LEN else FEATURE_LEN-1 for i in boundary]
        boundary = sorted(list(set(boundary)))
        tmp[boundary] = 1.
        event_boundaries.append(tmp)
    if len(event_boundaries) > 5:
        event_boundaries = random.sample(event_boundaries, 5)
    elif len(event_boundaries) < 5:
        for _ in range(5-len(event_boundaries)):
            dummy = event_boundaries[0]
            event_boundaries.append(dummy)
    assert len(event_boundaries) == 5
    event_boundaries = torch.stack(event_boundaries)

    shot_boundaries = []
    for annotations in video_annotation['change_shot']:
        tmp = torch.zeros(FEATURE_LEN,)
        boundary = []
        for pt in annotations:
            boundary.append(pt)
        boundary.sort()
        if interpolation:
            #duration = video_annotation['video_duration']
            duration = video_annotation['duration']
            boundary = [int(FEATURE_LEN*(i/duration)) if i/duration < 1 else FEATURE_LEN-1 for i in boundary]
        else:
            boundary = [int(i/TIME_UNIT) if int(i/TIME_UNIT) < FEATURE_LEN else FEATURE_LEN-1 for i in boundary]
        boundary = sorted(list(set(boundary)))
        tmp[boundary] = 1.
        shot_boundaries.append(tmp)
    if len(shot_boundaries) > 5:
        shot_boundaries = random.sample(shot_boundaries, 5)
    elif len(shot_boundaries) < 5:
        for _ in range(5-len(shot_boundaries)):
            dummy = shot_boundaries[0]
            shot_boundaries.append(dummy)
    assert len(shot_boundaries) == 5
    shot_boundaries = torch.stack(shot_boundaries)

    whole_boundaries = []
    for annotations in video_annotation['substages_timestamps']:
        tmp = torch.zeros(FEATURE_LEN,)
        boundary = []
        for pt in annotations:
            boundary.append(pt)
        boundary.sort()
        boundary = [int(i/TIME_UNIT) if int(i/TIME_UNIT) < FEATURE_LEN else FEATURE_LEN-1 for i in boundary]
        boundary = sorted(list(set(boundary)))
        tmp[boundary] = 1.
        whole_boundaries.append(tmp)
    if len(whole_boundaries) > 5:
        whole_boundaries = random.sample(whole_boundaries, 5)
    elif len(whole_boundaries) < 5:
        for _ in range(5-len(whole_boundaries)):
            dummy = whole_boundaries[0]
            whole_boundaries.append(dummy)
    assert len(whole_boundaries) == 5
    whole_boundaries = torch.stack(whole_boundaries)
    
    return event_boundaries, shot_boundaries, whole_boundaries
        
        
class NIA2022_GEBD(Dataset):
    def __init__(self, mode='train', n_fold=0):
        """
        mode in ['train', 'validation', 'test']
       
        """
        self.mode = mode
        #self.n_fold = str(n_fold)
    
        with open(ANNOTATION_PATH, 'r') as f:
            self.annotations = json.load(f)
        with open(FILE_LIST, 'r') as f:
            self.filenames = json.load(f)[mode]

    def __len__(self):
        return len(self.filenames)

    def __getitem__(self, idx):
    
        if self.mode=='train':
            tmp_interpolation = random.randint(0,10000)

            path1 = self.annotations[self.filenames[idx]]['path_feature']
            f1 = torch.from_numpy(load_feature(path1)).float()
            #vid1_annotation = self.annotations[self.filenames[idx]]
            vid1_annotation = self.annotations[os.path.basename(self.filenames[idx])]
            event1, shot1, whole1 = get_boundaries(vid1_annotation, interpolation=tmp_interpolation < 10000*INTERPOLATION_PROB)

            #glueing
            tmp = random.randint(0,10000)
            if tmp < 10000*GLUE_PROB:
                rand_idx = random.randint(0, self.__len__()-1)
                glue_point = random.randint(FEATURE_LEN // 4, (FEATURE_LEN // 4) * 3)
                
                path2 = self.annotations[self.filenames[rand_idx]]['path_feature']
                f2 = torch.from_numpy(load_feature(path2)).float()
                #vid2_annotation = self.annotations[self.filenames[rand_idx]]
                vid2_annotation = self.annotations[os.path.basename(self.filenames[rand_idx])]
                event2, shot2, whole2 = get_boundaries(vid2_annotation, interpolation=tmp_interpolation < 10000*INTERPOLATION_PROB)

                f = torch.cat((f1[:glue_point], f2[glue_point:]), dim=0)
                event_boundaries = torch.cat((event1[:, :glue_point], event2[:, glue_point:]), dim=1)
                shot_boundaries = torch.cat((shot1[:, :glue_point], shot2[:, glue_point:]), dim=1)
                shot_boundaries[:, glue_point] = 1.
                whole_boundaries = torch.cat((whole1[:, :glue_point], whole2[:, glue_point:]), dim=1)
                whole_boundaries[:, glue_point] = 1.
            else:
                f = f1
                event_boundaries = event1
                shot_boundaries = shot1
                whole_boundaries = whole1
            return f, event_boundaries, shot_boundaries, whole_boundaries
    
        else:
            path = self.annotations[self.filenames[idx]]['path_feature']
            #duration = self.annotations[self.filenames[idx]]['duration']
            duration = self.annotations[os.path.basename(self.filenames[idx])]['duration']
            f = torch.from_numpy(load_feature(path)).float()
            return f, self.filenames[idx], duration

